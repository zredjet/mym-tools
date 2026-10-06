use crate::module::ModuleBackend;
pub struct TextCleanModule;
impl ModuleBackend for TextCleanModule {
    fn id(&self) -> &'static str {
        "textclean"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
