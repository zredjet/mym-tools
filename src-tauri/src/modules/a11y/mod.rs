use crate::module::ModuleBackend;
pub struct A11yModule;
impl ModuleBackend for A11yModule {
    fn id(&self) -> &'static str {
        "a11y"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
