use crate::module::ModuleBackend;
pub struct CronModule;
impl ModuleBackend for CronModule {
    fn id(&self) -> &'static str {
        "cron"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
